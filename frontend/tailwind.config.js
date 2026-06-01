export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 0 40px rgba(112, 85, 255, 0.18)',
      },
      colors: {
        bg: '#0b1220',
        panel: '#111a2e',
        border: '#22305a',
        accent: '#6d5cff',
      },
    },
  },
  plugins: [],
}
