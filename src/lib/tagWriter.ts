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
  if (popm <= 19) return 10
  if (popm <= 39) return 20
  if (popm <= 63) return 30
  if (popm <= 90) return 40
  if (popm <= 116) return 50
  if (popm <= 140) return 60
  if (popm <= 166) return 70
  if (popm <= 195) return 80
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
      // POPM body layout is matched to taglib-wasm's model (empirically
      // verified): [owner \0][rating][counter(4)] — the rating byte lands
      // IMMEDIATELY after the null terminator and the 4 counter bytes trail.
      // This deviates from ID3v2.3 §4.15 ([owner \0][counter(4)][rating]);
      // writing the spec order makes taglib-wasm read the rating back as 0.
      // The owner must be a bare "MusicBee" — a leading 0x03 byte previously
      // became part of the owner string ("\x03MusicBee") in the parsed frame.
      const encoder = new TextEncoder()
      const emailBytes = encoder.encode("MusicBee")
      const popmBody = new Uint8Array(emailBytes.length + 1 + 1 + 4)
      popmBody.set(emailBytes, 0)
      popmBody[emailBytes.length] = 0
      popmBody[emailBytes.length + 1] = ratingToMp3Popm(rating)

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
