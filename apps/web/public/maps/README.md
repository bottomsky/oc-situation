# 海事地图资源

海图默认接入 OSM 在线矢量和 OpenSeaMap 海标；`maritime/manifest.json` 指向版本化自托管回退资源。当前安装的陆地、港口、航海要素状态及校验值以该 manifest 为准，准备入口为 `bun run maps:prepare`。在线开关与图源 URL、显示精度和更新方式见[海事 GIS 与概率预测](../../../../docs/maritime-gis.md)。

`ne_110m_land.geojson` 为 Natural Earth 110m 陆地矢量，仅绘制陆地和海岸线。

- 来源：[Natural Earth 维护仓库](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson)
- 授权：[公共领域许可](https://www.naturalearthdata.com/about/terms-of-use/)
- 获取日期：2026-10-01
- 来源文件 SHA-256：`9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`
- 仓库格式化文件 SHA-256：`09587327b1b491da3b5aaf664ea034a47dd5482fcd829bbb2dd75ce069bc790a`

仓库文件仅调整 JSON 排版，几何数据保持来源内容。

Natural Earth 始终提供全球概略背景；中国近海陆地与专用海岸线作为独立区域图层，在当前视口资源完整就绪后一起显示。区域资源失败时继续保留全球背景。`maritime/manifest.json` 的 `coastline` 记录已去除裁切边的派生线及其来源。专业电子海图与海底地形通过后续图源适配接入；数据许可、覆盖和服务条件随提供方确认。
