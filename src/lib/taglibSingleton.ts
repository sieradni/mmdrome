import { TagLib } from "taglib-wasm"

let instance: TagLib | null = null
let initPromise: Promise<TagLib> | null = null

export async function getTagLib(): Promise<TagLib> {
  if (instance) return instance
  if (!initPromise) {
    initPromise = TagLib.initialize().then((inst) => {
      instance = inst
      return inst
    })
  }
  return initPromise
}
