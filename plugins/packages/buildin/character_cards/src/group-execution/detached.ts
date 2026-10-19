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
