# Android CHANGELOG

已迁移到按月归档的 `changelog/YYYY/MM.md`。根目录 [CHANGELOG.md](../CHANGELOG.md) 是索引。

发版前把说明写成 `changelog/unreleased/` 下的碎片，在 main 上汇合后执行：

```bash
./scripts/changelog-cut.sh
cd android && bash build-apk.sh
```
