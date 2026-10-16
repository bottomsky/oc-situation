---
name: ui-control
description: 读取当前页面已注册的界面状态，操控海图面板、图层和浮窗，并根据浏览器回执确认结果。
metadata:
  version: '1.0.0'
allowed-tools: ui.list_capabilities ui.get_state ui.execute ui.get_command
---

# 界面感知与操作

先通过 ui.get_state 读取绑定页面的新鲜状态，使用 ui.list_capabilities 确认可用动作。
只有固定业务组件和白名单动作可以交给 ui.execute；不接受选择器、脚本、任意地址或属性写入。
ui.execute 返回已排队，不代表操作成功。等待原任务恢复，通过 ui.get_command 核对浏览器回执后回答。
关闭热力图包括热图图层、图例和网格浮窗，并终止该展示的加载及框选；历史结果和人工草稿保留。
目标不唯一时补问名称；未登记、离线、过期和未知执行结果不得推断为已关闭。
当前版本使用本地有限语义规划，不向外部模型发送界面内容。
