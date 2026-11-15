# 受控写入协议（Stage 1）

本文档是固定协议，供后续阶段（一致快照、隔离分支）复用。实现见
[0003_entry.sql](../packages/storage/migrations/0003_entry.sql)，常量见
[locks.ts](../packages/domain/src/locks.ts)。

## 1. 固定锁键

PostgreSQL advisory lock，双 int4 形式，命名空间 `1095128146`（`0x41465452`，ASCII `AFTR`）：

| 用途           | 调用                                   | 级别         |
| -------------- | -------------------------------------- | ------------ |
| 受控业务写     | `pg_advisory_xact_lock(1095128146, 1)` | 事务级、排他 |
| 迁移执行器互斥 | `pg_advisory_lock(1095128146, 2)`      | 会话级、排他 |

advisory lock 的作用域是「当前数据库」，开发库与测试库互不影响。

## 2. 写事务步骤

每个入口函数（`create_product` / `set_price` / `add_price_delta` / `batch_set_price` / `create_order`）严格按以下顺序执行：

1. **纯参数校验**（标识符格式、金额非负、数组形状）。不读任何表。
2. **`begin_commit`**
   1. 校验 principal；
   2. 要求事务隔离级别为 `READ COMMITTED`，否则以 `AC008` 拒绝；
   3. 获取 `pg_advisory_xact_lock(1095128146, 1)`；
   4. `UPDATE commit_watermark SET value = value + 1`，得到本次的 `commit_seq`；
   5. 写入 `commits` 行（`commit_seq`、`pg_txid`、`principal`、`db_role`）。
3. **读当前状态 → 业务写 → 审计**：`operations`（类型、模板版本、参数、批次、before/after）、
   `operation_reads`、`operation_writes`。

全部发生在调用方的同一个事务里。任何一步抛错，业务修改、审计行和水位推进一起回滚。

为什么必须是 `READ COMMITTED`：该级别下函数内每条语句都取新快照，所以拿到锁之后读到的一定是
前一个写事务已提交的结果。`REPEATABLE READ` / `SERIALIZABLE` 的快照早于拿锁的时刻，会读到旧值，因此直接拒绝。

## 3. 提交水位的含义

`commit_watermark.value` 是一行计数记录，只在持锁状态下 `+1`。它**不是** sequence、自增 ID、时间戳或事务 ID：

- 回滚的写不消耗水位，所以 `commits.commit_seq` 恒为 `1..水位`，无空洞；
- 锁在事务结束时才释放，而 PostgreSQL 先把事务标记为已提交、再释放锁，所以
  `commit_seq` 的顺序就是受控写事务的提交顺序；
- `commits.pg_txid` 与 `commits.recorded_at` 只是关联线索，不定义顺序。

一次入口调用消耗一个水位。批量操作的所有目标共享同一个 `commit_seq`，用 `ordinal_in_commit` 排序。

## 4. 读取项的依赖类别

`operation_reads.dependency_class` 区分两种读：

| 类别                | 含义                             | 是否传播价格污染 |
| ------------------- | -------------------------------- | ---------------- |
| `business_value`    | 写入值由读到的值计算得出         | 是               |
| `concurrency_guard` | 只为串行化写入、记录 before 快照 | 否               |

| 操作                            | 读取项                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| `create_product`                | 无                                                                   |
| `set_price` / `batch_set_price` | 商品 `version`、`price_cents`：均为 `concurrency_guard`              |
| `add_price_delta`               | 商品 `version`：`concurrency_guard`；`price_cents`：`business_value` |
| `create_order`                  | 商品 `price_cents`：`business_value`                                 |

绝对定价虽然读了旧行，但新价格不由旧价格算出，所以不会把旧价格的问题传播到新版本。
TypeScript 侧的声明在 [templates.ts](../packages/domain/src/templates.ts)，集成测试逐项对照数据库实际写入的审计行。

## 5. 版本规则

- 商品创建时 `version = 1`；每次成功的价格写入 `version + 1`，**同值写入也递增**，历史不合并。
- 订单只有创建，`version = 1`，保存 `unit_price_cents` 与读取到的 `price_version`，之后不可修改。
- `operation_writes` 记录 `version_before → version_after`；创建对象时 `version_before` 为 `NULL`。

## 6. 错误码

| SQLSTATE          | 契约层 code             | 含义                                  |
| ----------------- | ----------------------- | ------------------------------------- |
| `AC001`           | `invalid_argument`      | 标识符、principal、数量或批次形状非法 |
| `AC002` / `22003` | `amount_out_of_range`   | 结果或参数超出 bigint 范围            |
| `AC003`           | `negative_price`        | 价格或增量后的终价为负                |
| `AC004`           | `product_not_found`     | 商品不存在                            |
| `AC005`           | `already_exists`        | 商品或订单已存在                      |
| `AC008`           | `unsupported_isolation` | 隔离级别不是 READ COMMITTED           |
| `AC006`           | （不映射，直接抛出）    | 试图修改/删除只追加的历史             |
| `AC007`           | （不映射，直接抛出）    | 商品版本或水位没有按 +1 前进          |

## 7. 一致快照（后续阶段的复用方式，本轮未实现、未测试）

- **只读调查**：在一个 `REPEATABLE READ, READ ONLY` 事务里读 `commit_watermark` 得到 `W`，
  该事务内看到的业务数据与审计恰好对应 `commit_seq ≤ W`。因为写事务按锁串行提交，任何单一 MVCC 快照都是提交序列的一个前缀，读者不需要拿锁。
- **需要停写的操作**（例如创建隔离分支）：在 `READ COMMITTED` 事务里先取同一把
  `pg_advisory_xact_lock(1095128146, 1)`，持锁期间没有受控写能提交。

## 8. 保证的边界

这些保证成立的前提是：所有业务写都经过受控入口，且数据库管理员可信。

- 表 owner（迁移角色）或超级用户可以禁用触发器、改函数、直接改表。触发器只防误操作，**不防 DBA 篡改**。
- advisory lock 任何登录角色都能获取。持有登录凭证的一方可以长时间占锁使写入停顿（可用性问题），但无法借此绕过审计。
- 调用方若在显式事务里调用入口后迟迟不提交，同样会阻塞其他写入。`BusinessEntry` 每次调用是单语句隐式事务，不存在这个问题。
- `principal` 是受控应用自己声明的主体，数据库不验证其真实性；`db_role` 才是数据库实际认证的登录角色。
