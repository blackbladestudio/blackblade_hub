# 项目规则

## 注释规范

所有代码注释必须使用中文编写。

### 规则说明

- 代码中的注释（包括单行注释和多行注释）必须使用中文
- 这确保代码的可读性和一致性，便于团队协作
- 注释内容应该清晰、准确地描述代码的功能和逻辑

### 示例

```typescript
// 正确示例
// 获取用户配置信息
function getConfig() {
    // 验证配置是否有效
    if (!config.isValid) {
        // 返回默认配置
        return defaultConfig;
    }
}

/* 正确示例 - 多行注释
 * 这是一个多行注释示例
 * 用于描述复杂的业务逻辑
 */

/* 错误示例 - 请勿使用英文注释
// This is a comment in English - 不允许
function example() {
    // process data - 不允许
}
*/
