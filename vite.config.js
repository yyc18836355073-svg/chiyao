import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/chiyao/', // 确保仓库名是纯小写 chiyao
  plugins: [
    react()
  ]
});