# 产品文档脚本

默认源稿为 `docs/product/产品方案.md`，默认 Word 输出为同目录下的 `海上智能态势与筹划分析产品方案.docx`。默认路径相对于脚本所在仓库解析，支持从其他工作目录调用。

## 检查路径

```powershell
python scripts/documents/build_docx.py --check-paths
powershell.exe -NoProfile -File scripts/documents/export_word_pdf.ps1 -OutputPdf docs/product/产品方案.pdf -CheckPaths
```

两个检查入口均只验证路径。Python 检查在导入 `python-docx` 前返回，PowerShell 检查在创建 Word COM 对象前返回。

## 生成 Word

```powershell
python scripts/documents/build_docx.py
python scripts/documents/build_docx.py docs/product/产品方案.md --output docs/product/海上智能态势与筹划分析产品方案.docx
```

实际生成需要 Python 与 `python-docx`。显式指定的相对路径按调用工作目录解析；输出目录应先存在。执行会覆盖指定 Word 文件，更新正式交付件后需检查正文、表格和分页。

## 导出 PDF

```powershell
powershell.exe -NoProfile -File scripts/documents/export_word_pdf.ps1 -OutputPdf docs/product/产品方案.pdf
```

实际导出需要本机安装 Microsoft Word，脚本以不可见 COM 实例打开输入文档并导出 PDF。默认 Word 路径相对于脚本定位，显式输入及输出相对路径按调用工作目录解析。脚本使用 UTF-8 BOM，以支持 Windows PowerShell 5.1 对中文路径的解析。2026-10-17 迁移只执行路径及语法核验，未启动 Word 或重新导出正式文档。
