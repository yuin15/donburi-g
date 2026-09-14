# Task: remove-spin-instruction

- branch: `fix/remove-spin-instruction`
- status: pr-preparation
- updated: 2026-09-14

## Goal

SPIN ボタンの下に表示される `CLICK / SPACE TO SPIN` の案内文を削除する。

## Completed

- 重複タスクと既存 PR を確認
- clean な WS-3 を `origin/main` に同期
- `fix/remove-spin-instruction` ブランチを作成
- 初期案内のみを空にし、回転中・結果時の状態通知を残す方針を確定
- 対象3ファイルの実装を完了
- `git diff --check`、`npm run typecheck`、`npm test`（518件）、`npm run build` を通過
- 実画面で通常時の案内削除と回転中の待機表示を確認

## Current

- commit / push / Draft PR を準備中

## TODO

- commit / push / Draft PR
- fresh-context review

## Notes

- GitHub Issue は作成・参照しない。
