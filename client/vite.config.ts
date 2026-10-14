import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Only these values may be embedded in the public GitHub Pages bundle.
  const publicEnv = Object.fromEntries(
    ['API_URL', 'AVATAR', 'NAME', 'DESCRIPTION', 'PAGE_SIZE']
      .map(key => [key, env[key] || ''])
  );
  return {
    define: {
      'process.env': JSON.stringify(publicEnv)
    },
    plugins: [react()],
  }
})
