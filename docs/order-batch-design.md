# 订单批次设计方案

## 目标

解决下面这个业务问题：

- 同一个客户一天内可能来多次
- 上午已经结清的一批金子，不应该再算进下午新来的这一批
- 页面展示的总价，应该只统计“当前这一单”里的金子明细

核心原则：

- 客户是客户
- 订单是订单
- 金子明细是金子明细
- 汇总永远按订单汇总，不按客户当天全部记录汇总

## 为什么当前结构不够用

现在项目保存的是单条 `GoldRecord`，字段里只有：

- 顾客姓名
- 顾客手机号
- 本次称重和计算结果

这种方式适合“单块金子直接保存”，但不适合“一个客户一次带来多块金子”或“同一天来多次”的场景。

缺少的问题是：

- 没有“这一批/这一单”的唯一标识
- 没有订单状态，无法区分已支付和未支付
- 没有把多块金子归到同一单里的能力
- 总价只能看单条记录，不能稳定地计算“当前应付总额”

## 推荐的数据模型

建议改成 3 张表。

### 1. Customers

作用：存客户基础资料。

建议字段：

- `Customer ID`
- `Customer Name`
- `Customer Phone`
- `Last Visit At`
- `Notes`

说明：

- `Customer ID` 建议用系统生成的唯一值
- 实际查找客户时，优先用手机号，其次用姓名
- Airtable 里不要只依赖姓名，因为同名会混淆

### 2. Orders

作用：表示客户某一次到店的一整单。

建议字段：

- `Order ID`
- `Customer`
- `Order Number`
- `Status`
- `Created At`
- `Paid At`
- `Total Items`
- `Total Amount`
- `Notes`

字段说明：

- `Customer`：链接到 `Customers`
- `Status`：建议值为 `draft`、`paid`、`cancelled`
- `Total Items`：这单里一共有几块金子
- `Total Amount`：这单所有金子的小计之和

关键规则：

- 客户每来一次，就新建一条 `Orders`
- 上午来一次是一单，下午再来一次也是新的一单
- 已支付后把 `Status` 改为 `paid`
- 后续新来的金子不能继续加到已经 `paid` 的订单里

### 3. Gold Items

作用：存一单里的每一块金子明细。

建议字段：

- `Item ID`
- `Order`
- `Customer`
- `Saved At`
- `Rule Name`
- `Rule Constant`
- `Water Weight`
- `Dry Weight`
- `Tax Rate`
- `International Gold Price`
- `Purity`
- `Per Gram Price`
- `Final Price`
- `Line Total`
- `Item Status`

字段说明：

- `Order`：链接到 `Orders`
- `Customer`：可选，方便在 Airtable 里直接筛选
- `Line Total`：这一块金子的总价
- `Item Status`：可选，通常跟订单状态一致，也可以不单独维护

## 最适合你现在项目的保存逻辑

建议把“保存记录”拆成两个动作：

1. 新建订单
2. 往订单里添加金子明细

### 典型流程

#### 场景 A：上午第一次来

1. 选择客户
2. 点击“新建订单”
3. 录入第一块金子
4. 点击“加入当前订单”
5. 页面显示当前订单总件数和总金额
6. 客户付款后点击“完成支付”
7. 订单状态变成 `paid`

#### 场景 B：下午再次来

1. 再次选择同一个客户
2. 不要继续使用上午那张已支付订单
3. 点击“新建订单”
4. 录入下午的第一块和第二块
5. 当前页面只汇总这张新订单里的两条明细

这样就不会把上午已结清的金额重新算进去。

## 前端页面建议

建议页面从“单条计算器”升级成“订单工作台”。

### 页面顶部：当前交易信息

显示：

- 当前客户姓名
- 当前客户手机号
- 当前订单编号
- 当前订单状态
- 当前订单件数
- 当前订单总价

这样用户一眼就知道现在是在算哪一单。

### 左侧：单块金子计算表单

保留你现在已有的输入项：

- 顾客姓名
- 手机号
- 干重
- 水重
- 税点
- 国际金价
- 公式规则

按钮建议改成：

- `新建订单`
- `加入当前订单`
- `完成支付`
- `清空当前块`

按钮逻辑：

- `新建订单`：给当前客户创建一张新的 `draft` 订单
- `加入当前订单`：把当前这块金子的计算结果保存成一条 `Gold Item`
- `完成支付`：把当前订单状态改成 `paid`
- `清空当前块`：只清空当前输入，不影响订单里已添加的明细

### 右侧：当前订单明细

新增一个列表区域，展示当前订单里的所有金子：

- 第几件
- 干重
- 水重
- 纯度
- 每克金价
- 小计
- 删除

底部固定显示：

- 本单共几件
- 本单总金额

这样客户带来两块、三块、五块都能一目了然。

## 状态规则建议

建议只允许下面这些状态流转：

- `draft` -> `paid`
- `draft` -> `cancelled`

不要允许：

- `paid` 再继续新增金子

这样最安全，也最符合门店操作。

## 后端接口建议

你现在已有：

- `POST /api/calculate`
- `POST /api/records`

建议后续扩成下面这组接口：

### 客户

- `GET /api/customers?query=`
- `POST /api/customers`

### 订单

- `POST /api/orders`
- `GET /api/orders/{orderId}`
- `PATCH /api/orders/{orderId}`

### 订单明细

- `POST /api/orders/{orderId}/items`
- `GET /api/orders/{orderId}/items`
- `DELETE /api/orders/{orderId}/items/{itemId}`

其中最重要的是：

- 新建订单接口
- 往订单中加明细接口
- 查询当前订单汇总接口

## 和你当前代码的对应关系

你现在的 `GoldRecord` 更适合改名成 `OrderItemRecord`，因为它本质上是一块金子的计算结果，而不是完整订单。

建议未来拆成：

- `Customer`
- `Order`
- `OrderItem`

其中当前已有的这些字段：

- `ruleName`
- `ruleConstant`
- `waterWeight`
- `dryWeight`
- `taxRate`
- `intlGoldPrice`
- `purity`
- `perGramPrice`
- `finalPrice`
- `totalPrice`

都继续保留到 `OrderItem` 上即可，只是额外增加：

- `orderId`
- `customerId`

## Airtable 落地方式

如果你继续用 Airtable，推荐这样建表：

- `Customers`
- `Orders`
- `Gold Items`

链接关系：

- `Orders.Customer` -> 链接 `Customers`
- `Gold Items.Order` -> 链接 `Orders`
- `Gold Items.Customer` -> 可选链接 `Customers`

汇总字段：

- 在 `Orders` 里用 Airtable 的 Rollup 或 Lookup 统计 `Gold Items`
- 自动得到 `Total Items`
- 自动得到 `Total Amount`

这样你在 Airtable 后台也能非常直观地区分：

- 某个客户历史来过多少次
- 每次来店是哪一单
- 每一单里有几块金子
- 哪些单已经付款

## 最小改造路径

如果想分阶段做，建议按下面顺序推进。

### 第一阶段

先不改公式，只补“当前订单”能力：

- 前端新增“当前订单”状态
- 每添加一块金子，先放到前端订单列表中
- 页面内先实现本单汇总

这一阶段甚至可以先不接 Airtable，先把交互跑顺。

### 第二阶段

再接后端和 Airtable：

- 新建订单时写入 `Orders`
- 添加金子时写入 `Gold Items`
- 支付时更新 `Orders.Status`

### 第三阶段

再补历史查询：

- 按客户搜索历史订单
- 查看订单详情
- 查看已付款和未付款订单

## 我最推荐你现在先做的版本

最实用的一版是：

- 继续保留现有单块计算器
- 新增“当前订单明细列表”
- 新增“加入当前订单”而不是直接“记录到 Airtable”
- 新增“完成支付”
- 后端把数据按 `Order + OrderItem` 保存

这样改动不算太大，但业务上会一下子顺很多。

## 一句话结论

你这个项目下一步最合理的设计，不是“同一个客户当天累计多少金子”，而是“同一个客户每次来店生成一张新订单，这张订单里再包含多块金子明细”，页面总价永远只汇总当前订单。
