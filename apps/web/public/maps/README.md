# 离线开发地图

`ne_110m_land.geojson` 为 Natural Earth 110m 陆地矢量，仅绘制陆地和海岸线。

- 来源：[Natural Earth 维护仓库](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson)
- 授权：[公共领域许可](https://www.naturalearthdata.com/about/terms-of-use/)
- 获取日期：2026-10-01
- 来源文件 SHA-256：`9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`
- 仓库格式化文件 SHA-256：`09587327b1b491da3b5aaf664ea034a47dd5482fcd829bbb2dd75ce069bc790a`

仓库文件仅调整 JSON 排版，几何数据保持来源内容。

生产通过 `NUXT_PUBLIC_MAP_STYLE_URL` 或 `NUXT_PUBLIC_MAP_TILER_KEY` 配置托管底图。浏览器 Key 应限制部署域名。
