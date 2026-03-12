import { defineConfig } from 'vite';

export default defineConfig(async () => {
  // eslint-disable-next-line import/no-unresolved
  const { default: tailwindcss } = await import('@tailwindcss/vite');
  return {
    plugins: [tailwindcss()],
  };
});
