# 拼写检查手工样例（M2 收尾）

> 自动化限制：Electron 原生拼写检查的右键菜单在 headless / CUA 下无法稳定触发，因此本项保留为手工验收。

## 步骤

1. 启动 SubX，打开任意工程并选中一条字幕。
2. 在「项目设置 → 校对」确认「拼写检查」开启。
3. 在字幕正文依次输入下列单词（可逐条替换），等待系统词典标红。
4. 右键标红单词，确认出现系统建议或「添加到词典」。
5. 中文正文不应被英文词典标红。

## 样例（20 条）

```text
teh
recieve
adress
seperate
definately
occured
untill
wierd
becuase
freind
goverment
enviroment
calender
embarass
existance
foriegn
garantee
hieght
independant
knowlege
```

## 通过标准

- 至少 18/20 个单词出现系统建议或「添加到词典」。
- 中文样例不出现英文拼写建议。
- 关闭「拼写检查」后不再标红。

## 已知环境限制

- 词典语言固定 `en-US`。
- 无桌面会话 / 自动化右键菜单不可用，因此不进入 CI。