# AIS 离线样例

所有样例用于开发与测试。坐标与标识来自既有测试或合成数据，均标记为 synthetic，不能作为实际船舶态势证据。

| 文件                            | 格式                                   | 来源                                                   |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------ |
| aisstream-position.json         | AISStream PositionReport               | 既有 Python 离线测试，只读提取                         |
| aisstream-static.json           | AISStream ShipStaticData               | 既有 Python 离线测试，只读提取                         |
| aisstream-class-b-static.json   | AISStream StaticDataReport             | 既有 Python 离线测试，只读提取                         |
| aisstream-class-b-position.json | AISStream StandardClassBPositionReport | 合成                                                   |
| marinetraffic-v9.json           | MarineTraffic v9 DATA / METADATA       | 合成，SPEED 为节的十分之一，COURSE 为度；DRAUGHT 为分米      |
| marinetraffic-legacy.json       | MarineTraffic 旧样例                   | 既有 Python 离线测试，只读提取；单位与 v9 合成样例不同 |
| candidates.json                 | 标准候选位置、静态、隔离触发记录       | 合成                                                   |
| fixture-page.html               | HTTP 表格                              | 合成                                                   |
| fixture-browser.html            | 浏览器执行 JavaScript 后显示的表格     | 合成                                                   |

逐文件标记见 manifest.json；提供者报文保持原始形状，标记通过伴随清单表达。
