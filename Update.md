Hãy Update lại workflow của chatParticipants  theo một chuẩn format.
Document về gitnexus tool ở D:\me\AI\repo\gitnexus-vscode\GitNexus\gitnexus\README.md.
Workflow chuẩn cho tất cả tool
1. Context → hiểu scope
2. Analysis → gọi GitNexus tool
3. Insight → rút ra kết luận
4. Action → đề xuất hoặc thực thi
5. Self-check → cảnh báo / risk
Output format chuẩn: 
## 🧩 Context
- ...

## 🔍 Findings
- ...

## ⚠️ Impact / Risk (nếu có)
- ...

## ✅ Recommendation / Action
- ...

## 🧠 Self-check
- ...


/impact — Impact Analysis : 
User → /impact symbol

1. gitnexus_context(symbol)
2. gitnexus_impact(symbol)
3. analyze:
   - d-level
   - blast radius
   - call graph
4. summarize risk

Outputformat: ## 🧩 Context
Target symbol: OrderService.Create

## 🔍 Findings
- Direct callers: OrderController, CheckoutService
- Indirect dependents: PaymentService, NotificationWorker
- Fan-out: 8 modules

## ⚠️ Impact / Risk
- Level: 🔴 d1 (WILL BREAK)
- Reason:
  - Direct CALLS from 3 controllers
  - Used in critical checkout flow

## ✅ Recommendation
- Update all direct callers before merge
- Add integration test for checkout flow

## 🧠 Self-check
- Confirm no dynamic usage missed (reflection / runtime calls)



/explain — Code Understanding

Workflow
1. gitnexus_query (find symbol)
2. gitnexus_context (relationships)
3. build execution flow

Output format:
## 🧩 Context
File: demo/app.js

## 🔍 Findings

### Main Flow
1. bootstrap() → load user/session
2. setMode() → switch UI
3. handleRegister() → validate + save
4. handleLogin() → auth logic
5. setView() → update UI

### Data Flow
- User input → validation → localStorage
- Session → dashboard view

## ✅ Recommendation
- Entry point: bootstrap()
- Critical logic: handleRegister()

## 🧠 Self-check
- Flow assumes no backend interaction
``


/debug — Debugging
Workflow
1. gitnexus_query (error context)
2. gitnexus_context (execution path)
3. trace root cause
4. optional: minimal fix


ouput:
## 🧩 Context
Issue: Login fails with valid credentials

## 🔍 Findings
- handleLogin() compares hashed vs plain password
- Stored password format mismatch

## ⚠️ Impact / Risk
- Affects all login users
- Critical auth flow

## ✅ Recommendation
- Normalize password hashing logic
- Add validation guard

## 🧠 Self-check
- Verify no legacy users use old format

 /refactor — Refactoring
 Workflow
1. gitnexus_context
2. gitnexus_impact
3. đánh giá risk
4. apply change
5. verify scope

Output:
## 🧩 Context
Refactor: Rename parseConfig → parseWorkspaceConfig

## 🔍 Findings
- Direct callers: 4 modules
- Indirect usage in config loader

## ⚠️ Impact / Risk
- d1 (WILL BREAK)
- High fan-out

## ✅ Action Taken
- Renamed function
- Updated all direct callers

## ✅ Recommendation
- Run full test for config loading

## 🧠 Self-check
- Confirm no string-based reference remains


Mapping Command → Tool

Command |Tool chính|Mode
impact|gitnexus_impact|Required|
explain|gitnexus_context|query|Required/Auto
debug|gitnexus_query|Required|
refactor|impact + edit|Mixed
plan|query + impact|Auto


Standard Prompt Policy
"Always structure response as:
Context → Findings → Impact → Action → Self-check

Always run GitNexus tools before reasoning.

Always explain d-level and risk when available.""