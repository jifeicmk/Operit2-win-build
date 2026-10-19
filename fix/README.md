# Operit2 补丁包 v2（群组可用 + 不卡死 + 记忆恢复）

> 给电脑端使用。基于设备上实际编译的版本，补丁已逐条验证锚点。

---

## 一、本轮修了 4 个问题

| # | 症状 | 根因 | 位置 |
|---|---|---|---|
| 1 | 群组发消息报 `execution state is unavailable`，从没见过任何输出 | 钩子把工作丢后台后立即返回，宿主回收了执行状态 | `character_cards` 插件 |
| 2 | **消息发不出去，一直"正在处理消息"，必须杀进程重开** | 流程被宿主超时杀掉后 `work` 永不 settle → 锁永远不释放 | `character_cards` 插件 |
| 3 | 记忆提取报 `Unexpected end of JSON input` | 只接受严格 JSON，模型输出带解释文字就整次失败 | `character_cards` 插件 |
| 4 | 群组/记忆偶尔报 `timed out after 60000/10000 ms` | **宿主硬编码 `clamp(1, 60)` + 10 秒钩子预算** | 宿主 Rust |

> 问题 1/3 已在你之前那次编译中生效（实测群组能出角色回复、记忆库已成功提取 2 条）。
> 本轮新增 **问题 2 的看门狗修复** 和 **问题 4 的宿主补丁**。

---

## 二、插件补丁（TypeScript）

目标目录（你仓库里的路径）：

```
plugins/packages/buildin/character_cards/
```

### 文件 1：`src/group-execution/detached.ts`（**新增**）

```ts
/**
 * Keeps the current ToolPkg call alive after its hook returns, so a retained group
 * sequence can keep calling host APIs with a valid execution state.
 *
 * The runtime exposes these primitives to every plugin realm and relies on them
 * itself (see setTimeout / callDependency in JsLibraries.rs): while a call still has
 * pending references, the runtime marks it `detached` and notifies the host through
 * __operitNotifyDetachedCall instead of cleaning the session up as soon as the hook
 * settles. That is exactly the lifetime a group sequence needs.
 */
export function retainDetachedWork(work: Promise<unknown>): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const callId = typeof scope.__operitCurrentCallId === "string" ? scope.__operitCurrentCallId : "";
  const retain = scope.__operitRetainCallReference;
  const release = scope.__operitReleaseCallReference;
  if (callId === "" || typeof retain !== "function") return;

  try {
    (retain as (id: string) => void)(callId);
  } catch {
    return;
  }

  /** Releases exactly the reference acquired above, once the work settles. */
  const dispose = (): void => {
    try {
      if (typeof release === "function") (release as (id: string) => void)(callId);
    } catch {
      /* A session that is already gone needs no release. */
    }
  };
  void work.then(dispose, dispose);
}
```

### 文件 2：`src/group-execution/hooks.ts`（**4 处改动**）

**2a. 加 import**

```diff
 import { NativeGroupTurnTransport } from "./native-transport";
+import { retainDetachedWork } from "./detached";
```

**2b. 加看门狗容器**（在 `const executions = ...` 之后）

```diff
 const executions = new Map<string, InputExecution>();
+/** Bounds each admitted submission so a host-killed continuation cannot lock the chat. */
+const watchdogs = new Map<InputExecution, ReturnType<typeof setTimeout>>();
```

**2c. 改 `observe()` —— 增加看门狗（这是修"卡死"的关键）**

```diff
 function observe(execution: InputExecution, work: Promise<GroupExecutionOutcome>): void {
   void work.then(
-    outcome => { execution.status = "settled"; execution.outcome = outcome; },
-    failure => { execution.status = "failed"; execution.failure = failure; console.error("Group input " + execution.input.submissionId + " failed: " + String(failure)); },
+    outcome => { clearWatchdog(execution); execution.status = "settled"; execution.outcome = outcome; },
+    failure => { clearWatchdog(execution); execution.status = "failed"; execution.failure = failure; console.error("Group input " + execution.input.submissionId + " failed: " + String(failure)); },
   );
+  armWatchdog(execution);
 }
+
+/**
+ * Bounds how long one admission may stay "running".
+ *
+ * The host kills long continuations (script/pre-hook deadlines), and a killed
+ * continuation never settles its promise. Without this guard the retained entry
+ * would stay "running" forever, so every later send would be blocked and the
+ * conversation would sit on "processing" until the app was restarted.
+ */
+const ADMISSION_TIMEOUT_MS = 600000;
+
+/** Starts the bounded admission timer that releases a stuck group lock. */
+function armWatchdog(execution: InputExecution): void {
+  const timer = setTimeout(() => {
+    if (execution.status !== "running") return;
+    execution.status = "failed";
+    execution.failure = new Error("Group submission exceeded the local admission deadline");
+    console.error("Group input " + execution.input.submissionId + " watchdog released a stuck admission");
+  }, ADMISSION_TIMEOUT_MS);
+  watchdogs.set(execution, timer);
+}
+
+/** Cancels the admission timer once the retained work actually settles. */
+function clearWatchdog(execution: InputExecution): void {
+  const timer = watchdogs.get(execution);
+  if (timer === undefined) return;
+  watchdogs.delete(execution);
+  clearTimeout(timer);
+}
```

**2d. 加保活调用**（`observe(execution, work);` 之后）

```diff
   observe(execution, work);
+  retainDetachedWork(work);
   return { action: "Consume", clearInput: true, metadata: { ... } };
```

### 文件 3：`src/memory-jobs/analysis.ts`（`parseModelJson` 容错）

```diff
 export function parseModelJson(text: string): unknown {
-  assertString(text, "model output"); const trimmed = text.trim();
+  assertString(text, "model output");
+  const trimmed = text.trim();
+
+  // 1) The documented shape first: a bare object/array, or one complete fence.
   const fence = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(trimmed);
-  return JSON.parse(fence === null ? trimmed : fence[1]);
+  const primary = fence === null ? trimmed : fence[1];
+  try { return JSON.parse(primary); } catch { /* fall through to salvage */ }
+
+  // 2) Salvage the first complete JSON value from surrounding prose, a partial or
+  //    unterminated fence, or trailing chatter. Interchange and reasoning models
+  //    frequently wrap the object in explanation; that must not fail extraction.
+  const recovered = extractFirstJsonValue(trimmed);
+  if (recovered !== null) return JSON.parse(recovered);
+  return JSON.parse(primary);
 }
+
+/** Scans for the first balanced JSON object or array, ignoring braces inside strings. */
+function extractFirstJsonValue(text: string): string | null {
+  const opening = text.search(/[\[{]/u);
+  if (opening < 0) return null;
+  const open = text[opening], close = open === "{" ? "}" : "]";
+  let depth = 0, inString = false, escaped = false;
+  for (let index = opening; index < text.length; index += 1) {
+    const char = text[index];
+    if (inString) {
+      if (escaped) escaped = false;
+      else if (char === "\\") escaped = true;
+      else if (char === '"') inString = false;
+      continue;
+    }
+    if (char === '"') { inString = true; continue; }
+    if (char === open) depth += 1;
+    else if (char === close) {
+      depth -= 1;
+      if (depth === 0) return text.slice(opening, index + 1);
+    }
+  }
+  return null;
+}
```

> 这些 `.ts` 必须是 **CRLF 行尾**（与仓库一致）。

---

## 三、宿主补丁（Rust）—— 解决 60 秒 / 10 秒超时

### 文件：`core/crates/runtime/application/src/data/preferences/ApiPreferences.rs`

**三处** `clamp(1, 60)` → `clamp(1, 600)`：

```diff
     pub fn toolPkgPreHookTimeoutSecondsFlow(&self) -> Flow<i32> {
         self.apiDataStore.dataFlow().mapResult(|preferences| {
             Ok(preferences
                 .getTyped::<i32>(&stringPreferencesKey("toolpkg_pre_hook_timeout_seconds"))?
                 .unwrap_or(Self::DEFAULT_TOOLPKG_PRE_HOOK_TIMEOUT_SECONDS)
-                .clamp(1, 60))
+                .clamp(1, 600))
         })
     }
```

```diff
     pub fn saveToolPkgPreHookTimeoutSeconds(
         &self,
         seconds: i32,
     ) -> Result<(), PreferencesDataStoreError> {
         self.apiDataStore.edit(|preferences| {
             preferences.set(
                 &stringPreferencesKey("toolpkg_pre_hook_timeout_seconds"),
-                seconds.clamp(1, 60),
+                seconds.clamp(1, 600),
             );
         })
     }
```

```diff
     pub fn getToolPkgPreHookTimeoutSeconds(&self) -> Result<i32, PreferencesDataStoreError> {
         let preferences = self.apiDataStore.data()?;
         Ok(preferences
             .getTyped::<i32>(&stringPreferencesKey("toolpkg_pre_hook_timeout_seconds"))?
             .unwrap_or(Self::DEFAULT_TOOLPKG_PRE_HOOK_TIMEOUT_SECONDS)
-            .clamp(1, 60))
+            .clamp(1, 600))
     }
```

### 文件：`core/crates/runtime/application/src/plugins/toolpkg/ToolPkgPreHookTimeout.rs`

```diff
     pub fn fromSeconds(seconds: i32) -> Self {
-        let durationMillis = i64::from(seconds.clamp(1, 60)) * 1000;
+        let durationMillis = i64::from(seconds.clamp(1, 600)) * 1000;
         Self {
             deadlineMillis: currentTimeMillis() + durationMillis,
         }
     }
```

> 改完后，UI 里若暴露了「ToolPkg 预钩子超时」，可以调到 600 秒。
> 另外可顺带搜索 `10000` 附近的钩子预算（`input_changed` 10 秒那条），按同样思路放宽。

---

## 四、编译

```bash
cd plugins/packages/buildin/character_cards
node scripts/build.mjs      # 生成 dist/character_cards.toolpkg
node scripts/check.mjs      # 类型检查
node --test tests/*.test.mjs   # 官方测试
```

再到仓库根目录走你原来的 GitHub Actions 流程。内置插件会在构建时自动打包并 `include_bytes!` 进 `liboperit_flutter_bridge.so`。

---

## 五、验证清单

| 场景 | 期望 |
|---|---|
| 群组发一条消息 | 多个角色依次回复，不再报 `explicit execution participant` |
| 群组里连发几条 | 不再出现「一直正在处理消息」；即使某次失败，也能继续发 |
| 触发记忆更新 | 不再报 `Unexpected end of JSON input` |
| 大群组（10+ 成员） | 不再撞 60 秒上限 |
| 长时间不操作 | 不会因为锁残留导致发不出消息 |

---

## 六、附带说明（数据库侧，已在设备上处理）

- 清掉 18 条来自旧 `operit1` 库的僵尸候选（重试过 38 次）
- 29 条 failed：3 条源消息已不存在 → 删除；26 条可重试 → 重置为 pending
- `nextId` 目前 15276，校验正常（`fix_nextid.sh` 不需要再跑）
- 备份在 `/sdcard/MT2/backup/`

---

## 七、已生成的成品

本目录一并提供**可直接覆盖**的文件：

```
fix/
├── src/group-execution/detached.ts     ← 新增
├── src/group-execution/hooks.ts        ← 覆盖
├── src/memory-jobs/analysis.ts         ← 覆盖
└── README.md                           ← 本文档
```