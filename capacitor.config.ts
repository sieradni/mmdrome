import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mmdrome.player',
  appName: 'mmdrome',
  webDir: 'dist',
  ios: {
    backgroundColor: '#ffffff',
    zoomEnabled: false,
  },
}

export default config