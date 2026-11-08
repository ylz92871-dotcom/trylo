# 检查学习子系统

当前只完成目录整理，进一步设计和自动启用暂缓。导入 `index.ts` 不会启动学习；默认关闭，泛 `all` 开关不包含检查学习。保留 `--learning=check`、`--check-learning`、`learn check` 等既有显式入口，本次没有运行真实学习。

```text
check/
  index.ts                 对外入口
  domain/
    legacy/                原 v1 合同、解析、改进算法
    v2/                    可执行检查合同、解析、提示、评估和曝光指纹
  runtime/
    legacy/                原 v1 编排
    v2/                    生成、额度、job、运行预留、反馈、恢复及版本资格
  application/             操作分发、任务队列/时点、事实采集和结果投影
  adapters/
    board/                 使用共享 Board 的读写与持久记录解码
    execution/             既有受限执行器的检查适配、产物回读
    provider/              生成器适配
    schema/                既有结构验证适配与检查标签兼容判断
    process/               owner 存活探测
```

相邻的既有测试随实现迁入；CLI 命令与宿主接点测试仍在 CLI。领域层不反向依赖适配器或 CLI。共享 Board、Permission、通用执行器、协议和 UI 的所有权没有搬动。这里的 Board adapter 复用原 writer，不创建另一个状态库。

CLI 只保留参数、配置/凭据/权限组装、启用判断、终端输出和完成/关闭接点。其旧导出签名保持；原 home/Board/scratch 路径、资产标识和持久化格式不变。

## 迁移和兼容

| 原位置 | 当前实现位置 |
| --- | --- |
| `learning/check/*.ts` | `domain/legacy/` |
| `learning/check/v2/` | `domain/v2/` |
| `integration/check-learning/{runtime,index}.ts` | `runtime/legacy/` |
| `integration/check-learning/board.ts` | `adapters/board/artifacts.ts` |
| `integration/check-learning/records.ts` | `adapters/board/legacy-records.ts` |
| `integration/check-learning/v2/{store,generation-record}.ts` | `adapters/board/` |
| 其他 `integration/check-learning/v2/` | `runtime/v2/` |
| `adapters/check-learning/` | `adapters/{provider,schema,process}/` |
| CLI 内检查专属主体 | `application/`、`adapters/{execution,schema}/` |

原三个专属目录保留 29 个无业务逻辑的兼容导出，不保留重复注册测试的兼容壳。已知消费者包括 `scripts/learning/check-learning*.mjs` 的固定编译路径，以及 CLI 既有测试中的旧 parse/contracts 引用。兼容范围保留原叶模块路径，供已有独立调用和并行工作继续使用；后续专门清理在调用方完成迁移后再删除，本次不删入口。

CLI 的 `check-learning-runtime.ts` 继续为 native-probe 等旧调用方提供原 homeDir 签名薄装配；`commands-check-learning.ts`、`check-learning-wiring.ts`、参数入口保持原位置。历史脚本、证据、源码快照和运行数据保持原位。

详细映射和本次有限检查见工程产出的《检查学习目录归并与默认关闭》记录。
