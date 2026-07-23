import { getTagLib } from "./taglibSingleton"

export function ratingToMp3Popm(rating: number): number {
  if (rating <= 0) return 0
  if (rating <= 10) return 13
  if (rating <= 20) return 26
  if (rating <= 30) return 54
  if (rating <= 40) return 78
  if (rating <= 50) return 104
  if (rating <= 60) return 128
  if (rating <= 70) return 154
  if (rating <= 80) return 178
  if (rating <= 90) return 204
  return 255
}

export function popmToLocalRating(popm: number): number {
  if (popm <= 0) return 0
  if (popm <= 8) return 10
  if (popm <= 20) return 20
  if (popm <= 59) return 30
  if (popm <= 100) return 40
  if (popm <= 121) return 50
  if (popm <= 157) return 60
  if (popm <= 190) return 70
  if (popm <= 219) return 80
  if (popm <= 248) return 90
  return 100
}

export async function modifyMetadataBuffer(
  arrayBuffer: ArrayBuffer,
  rating: number,
  loved: boolean,
  fileType: string,
): Promise<ArrayBuffer> {
  const taglib = await getTagLib()

  const modified = await taglib.edit(arrayBuffer, async (file) => {
    if (fileType === "mp3") {
      const encoder = new TextEncoder()
      const email = "MusicBee"
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
