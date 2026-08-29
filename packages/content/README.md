# @wuyan/content

“无烟同行”内部版的版本化内容与证据事实源。全部内容固定为 `draft/internal`，尚未经过具名医学审核，不得发布到生产渠道。

主要导出：

- `contentBundle` / `CONTENT_ITEMS` / `contentById`
- `evidenceSources` / `EVIDENCE_CATALOG` / `evidenceById`
- `CLAIM_MATRIX` / `contentItemsByKind`
- `getContentItem(id)` / `getContentBootstrap()`

校验：`pnpm --filter @wuyan/content verify`。脚本检查 73 个稳定 ID、分类数量、正文长度、医疗边界、禁用宣传语及内容—证据—主张引用闭包。
