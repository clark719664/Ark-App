/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#08090c', 900: '#0d0f14', 850: '#12151c', 800: '#181c25',
          700: '#232936', 600: '#333b4d', 500: '#4a5468', 400: '#6b768d',
          300: '#94a0b8', 200: '#c3cbdb', 100: '#e6eaf2',
        },
        turf: { 400: '#4ade80', 500: '#22c55e', 600: '#16a34a' },
        flag: { 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b' },
        blitz: { 400: '#f87171', 500: '#ef4444' },
        chalk: { 400: '#60a5fa', 500: '#3b82f6' },
        plum:  { 400: '#c084fc', 500: '#a855f7' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
