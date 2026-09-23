# locale/ —— 语言包目录

这个目录就是网页端的全部本地化：**一个 JSON = 一门语言，文件名就是语言码**。

```
web/src/locale/
  zh-CN.json     简体中文（兜底语言：其它语言缺的 key 一律回退到这里）
  en-US.json     English
  ja-JP.json     想加就加，不用改任何代码
```

## 加一门语言

```bash
# 1. 生成骨架（key 与来源语言一致，value 先留空）
node scripts/i18n-new-locale.mjs --lang ja-JP --name 日本語

# 2. 打开 web/src/locale/ja-JP.json 逐条翻译
#    没翻的条目运行时自动回退到 zh-CN，所以可以翻一半就上线，界面不会出现空白

# 3. 刷新页面：右上角语言菜单里直接多出「日本語」
node scripts/i18n-audit.mjs   # 看还差多少条（缺 key 才算错误，空值只算待翻译）
```

## 文件格式

```jsonc
{
  "_name": "日本語",            // 语言菜单里显示的名字；以 _ 开头的是元数据，不是译文
  "nav.chat": "チャット",       // key 固定，value 是译文；花括号占位符原样保留
  "agents.listTitle": "AI メンバー（{n}）"
}
```

- **key 固定**：代码里只写 `t('nav.chat')`，改文案不用动代码。
- **占位符**：`{n}`、`{name}`、`{tag}` 这些必须原样保留，运行时按调用方传的值替换。
- **空值 = 未翻译**：`""` 会被当成没翻，回退到 `zh-CN`。
- **元数据文件**：文件名以 `_` 开头的 JSON 会被整体忽略，可以拿来放草稿。

## 不参与服务端通信

语言选择只存在浏览器 `localStorage`（键名 `agenthub-locale`），**不进入任何 HTTP/WebSocket 请求**。
服务端发来的系统消息走 `meta.i18nKind` + `meta.i18nParams`，由前端按 `system.<kind>` 渲染；
认不出的 key 原样显示服务端文本，所以加语言不会影响接口契约。
