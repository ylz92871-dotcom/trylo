# Apache-2.0 可隔离评估

> 分类导航，不是设计权威。本分类目前无已归档来源卡；新资料及证据进入 `_workspace/research/<主题>/`。

本目录保存 Apache-2.0 的 B 级 adapter、C 级开发/构建工具和 D 级官方可选扩展候选。放入这里不代表已批准采用。

每份来源卡除普通依赖信息外，还必须记录：

- A–E 架构等级和理由；
- Trylo 自有 port/DTO，第三方类型的终止位置；
- 上游 LICENSE、NOTICE、文件级例外与修改声明要求；
- 哪些文件进入 source package、bundle、installer 或 sidecar；
- 合同测试、替换方案、升级策略与故障降级；
- 若靠近 A 级核心，产品所有者批准的例外 ADR。

Apache-2.0 组件可以被使用，但不能借“宽松许可”绕过核心主权、NOTICE/SBOM 或供应链审计。
