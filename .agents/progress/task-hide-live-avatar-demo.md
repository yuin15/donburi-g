# Task: hide-live-avatar-demo

- branch: `feature/hide-live-avatar-demo`
- status: pr-preparation
- updated: 2026-09-14

## Goal

採用しないことになった Live Avatar demo を、関連機能を削除せず画面上で非表示にする。

## Completed

- 重複するブランチと Open PR がないことを確認
- clean な WS-3 を最新 `origin/main` に同期
- `feature/hide-live-avatar-demo` ブランチを作成
- 通常ユーザー向け Live Avatar 導線が開始ゲート内の `#avatarVideo` のみであることを確認
- Live Avatar 実装と音声のみの接続経路を維持する最小変更方針を確定
- `src/view/GameTemplate.ts` の対象ラベルへ `hidden` を追加
- `src/style.css` で既存の `display:flex!important` より非表示指定を優先
- `git diff --check`、typecheck、lint、518 tests、build を通過
- 実ブラウザーで LiveAvatar 項目の非表示と音声接続ボタンの表示を確認

## Current

- commit / push / Draft PR を準備中

## TODO

- commit / push / Draft PR
- fresh-context review

## Notes

- GitHub Issue は作成・参照しない。
- Live Avatar のコードや設定は削除せず、画面上の導線だけを非表示にする。
