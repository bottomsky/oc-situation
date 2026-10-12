# 开源情报参考仓库

五个参考仓库已下载至 `references/osint`。每个目录保留独立 Git 仓库，清单 `references/osint/manifest.json` 记录上游、实际 HEAD、许可证、参考模块和文件大小。WorldMonitor 与 OpenCTI 使用浅层、按需 blob 及稀疏检出；列出的参考模块已实际下载，可在本地阅读。其他仓库完整浅层检出。

| 仓库                                                          | 下载版本                                   | 许可                                      | 参考范围                                                                         |
| ------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------- |
| [WorldMonitor](https://github.com/koala73/worldmonitor)       | `968eac6bb03abec85b02f0e014a2c7835f28ee1d` | AGPL-3.0                                  | `src/services/maritime/index.ts`、`gdelt-intel.ts`：来源分层、海事覆盖和新闻信号 |
| [OpenCTI](https://github.com/OpenCTI-Platform/opencti)        | `5f0be2a00918ce6f8470ec58e18e97d1dc439edb` | Community Apache-2.0；Enterprise 独立许可 | `stixCoreRelationship.ts`、`stixDomainObject.ts`：对象与关系的独立生命周期       |
| [FollowTheMoney](https://github.com/alephdata/followthemoney) | `c70a89ffa59ea785956f6095643310da3735b7fb` | MIT                                       | `followthemoney/model.py`、`proxy.py`：实体别名、类型与证据                      |
| [Terra Draw](https://github.com/JamesLMilner/terra-draw)      | `911d9b492ca1a8b361cb0198894fc5cc3f2b4df5` | MIT                                       | 选择模式、多边形校验：绘制后编辑、保存和人工确认                                 |
| [Turf](https://github.com/Turfjs/turf)                        | `0c20329dfc2b63555ddd5d5388c4858669df6037` | MIT                                       | `turf-boolean-intersects`、`turf-boolean-valid`：空间候选与有效性检查            |

这些仓库用于架构和交互参考。本次实现自行编写采集、坐标提取、修订和对象候选逻辑，未复制上游源码，也未运行下载仓库脚本或安装其依赖。WorldMonitor 的 AGPL 源码仅用于阅读；后续复制、修改或集成上游代码须按具体文件许可执行。OpenCTI 当前版本社区与企业许可分别适用，应检查文件头和根 `LICENSE`。MIT 代码后续复用时保留许可和版权声明。

## 官方数据接口依据

浙江来源使用[航行警告列表](https://www.zj.msa.gov.cn/ZJ/wszw/bmcx/hsskcx/hxjg/)，上海来源入口依据[上海海事局门户](https://www.sh.msa.gov.cn/)中公开链接，实际列表为[全国海事上海公告栏目](https://www.msa.gov.cn/94df14ce1110415da44e67593e76619f/index.jhtml)。GDACS 接口依据[官方 Swagger](https://www.gdacs.org/gdacsapi/swagger/index.html)和[YAGI 官方资源页](https://www.gdacs.org/resources.aspx?episodeid=17&eventid=1001090&eventtype=TC&sourceid=JTWC)，其资源页标注 EC-JRC 数据与 CC BY 4.0 署名要求。

GDELT 的新闻检索与位置语义分别依据[DOC2 官方文档](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)和[GEO2 官方文档](https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/)。GEO 地点是新闻语句中的提及位置，当前实际响应状态与验收结果见 `docs/intelligence-ingestion.md` 及本地验证清单。
