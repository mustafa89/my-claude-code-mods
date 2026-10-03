export type Preview = {
  /** Source size in pixels. */
  width: number
  height: number
  /** The picture as a PNG, base64, downscaled to fit the Image byte limit. */
  png: string
}

declare module 'claude-code' {
  interface PluginState {
    'image-peek': {
      /** Image numbers referenced by the prompt draft, in order. */
      draft: number[]
      /** Previews by image number. */
      pictures: Record<string, Preview>
    }
  }
}
