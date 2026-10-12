export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@nuxt/ui', './integrations/liveProxyModule'],
  css: ['~/assets/main.css', 'maplibre-gl/dist/maplibre-gl.css', '~/assets/workbench.css'],
  ui: { fonts: false },
  nitro: {
    devProxy: { '/api': { target: 'http://127.0.0.1:13000/api', changeOrigin: false } },
  },
  app: {
    head: {
      title: '智能海图 · AIS 综合态势系统',
      htmlAttrs: { lang: 'zh-CN' },
      meta: [{ name: 'description', content: 'AIS 船位、轨迹、专题推送与证据追溯' }],
    },
  },
});
