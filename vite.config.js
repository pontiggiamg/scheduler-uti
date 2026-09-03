import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /* Las librerías van en su propio archivo, aparte del código nuestro.

           No es sólo prolijidad: Firebase y React casi nunca cambian, y el
           navegador guarda cada archivo con un nombre que depende de su
           contenido. Separados, un deploy nuevo hace que se vuelva a bajar
           únicamente lo que tocamos —unos pocos KB— en vez de todo otra vez.
           Con los deploys que hacemos por semana, y gente entrando desde el
           celular con la señal del hospital, eso se nota.

           Firebase va aparte de React a propósito: es el pedazo más grande
           con diferencia, y no tiene por qué re-bajarse si algún día
           actualizamos React. */
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('firebase') || id.includes('@firebase')) return 'firebase'
          if (id.includes('react')) return 'react'
          return 'librerias'
        },
      },
    },
  },
})
