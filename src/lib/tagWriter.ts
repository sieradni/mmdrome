import { TagLib } from "taglib-wasm"

export function ratingToMp3Popm(rating: number): number {
  if (rating <= 0) return 0
  if (rating <= 10) return 13
  if (rating <= 20) return 1
  if (rating <= 30) return 54
  if (rating <= 40) return 64
  if (rating <= 50) return 118
  if (rating <= 60) return 128
  if (rating <= 70) return 186
  if (rating <= 80) return 196
  if (rating <= 90) return 242
  return 255
}

export function popmToLocalRating(popm: number): number {
  if (popm <= 0) return 0
  if (popm <= 6) return 20
  if (popm <= 33) return 10
  if (popm <= 58) return 30
  if (popm <= 90) return 40
  if (popm <= 122) return 50
  if (popm <= 156) return 60
  if (popm <= 190) return 70
  if (popm <= 218) return 80
  if (popm <= 248) return 90
  return 100
}

export async function modifyMetadataBuffer(
  arrayBuffer: ArrayBuffer,
  rating: number,
  loved: boolean,
  fileType: string,
): Promise<ArrayBuffer> {
  const taglib = await TagLib.initialize()

  const modified = await taglib.edit(arrayBuffer, async (file) => {
    if (fileType === "mp3") {
      const encoder = new TextEncoder()
      const email = "Windows Media Player 9 Series"
      const emailBytes = encoder.encode(email)
      const popmBody = new Uint8Array(1 + emailBytes.length + 1 + 1 + 4)
      popmBody[0] = 0x03
      popmBody.set(emailBytes, 1)
      popmBody[1 + emailBytes.length] = 0
      popmBody[1 + emailBytes.length + 1] = ratingToMp3Popm(rating)

      file.setId3v2Frames("POPM", [popmBody])

      const props = file.properties()
      if (loved) {
        props["LOVE RATING"] = ["L"]
      } else {
        delete props["LOVE RATING"]
      }
      file.setProperties(props)
    } else {
      const props = file.properties()
      props["RATING"] = [String(Math.round(rating))]
      if (loved) {
        props["LOVE RATING"] = ["L"]
      } else {
        delete props["LOVE RATING"]
      }
      file.setProperties(props)
    }
  })

  return modified.buffer.slice(modified.byteOffset, modified.byteOffset + modified.byteLength) as ArrayBuffer
}
