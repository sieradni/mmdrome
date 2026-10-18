import { mapNativePreloadEvent, type NativePreloadProgressEvent } from './loadStatus'
import { emitPreloadEvent } from '../stores/loadStatus'

/** The native listener and browser regression share the actual store adapter. */
export function forwardNativePreloadProgress(event: NativePreloadProgressEvent): void {
  emitPreloadEvent(mapNativePreloadEvent(event))
}
