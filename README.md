# donburi-g

OpenAI GPT-Live と HeyGen LiveAvatar を接続し、女性アバター「リナ」と
日本語でスロットについて会話できるデモです。

メイン実装は [`liveavatar-demo/`](./liveavatar-demo/) です。HeyGen公式の
[`liveavatar-gpt-live-demos`](https://github.com/heygen-com/liveavatar-gpt-live-demos)
（MIT License）をベースに、スロット同伴キャラクター向けへ変更しています。

GPT-Liveの音声をLiveAvatarのLITE media serverへ直接送り、LiveKit経由で
リップシンク済みの映像と音声をブラウザへ届けます。ブラウザにAPIキーは
渡りません。

## 必要なもの

- Node.js 20.12以上
- pnpm
- GPT-Liveを利用できるOpenAI API key
- HeyGen LiveAvatar API key
- マイクを利用できるブラウザ

## 起動

```bash
cd liveavatar-demo
pnpm install
pnpm run setup
pnpm dev
```

`pnpm run setup` が2つのAPIキーを確認し、`liveavatar-demo/.env` を作成します。
手動設定する場合は `.env.example` を `.env` にコピーし、次を設定します。

```dotenv
LIVEAVATAR_API_KEY=
OPENAI_API_KEY=
LIVEAVATAR_AVATAR_ID=65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0
```

[http://localhost:5173](http://localhost:5173) を開き、
「会話をはじめる」を押してマイクを許可してください。リナが先に挨拶し、
そのまま全二重音声で会話できます。

## 確認

```bash
cd liveavatar-demo
pnpm typecheck
pnpm build
```

## 現在の範囲

このマイルストーンは「アバターと音声会話できるところまで」です。スロットの
リール映像や結果はまだモデルへ渡していないため、リナはユーザーが話した状況に
反応します。次の段階で画面キャプチャまたはゲームイベントを接続します。

リポジトリ直下の旧 `npm` 実装は初期検証用です。動作確認には上記の公式実装
ベースを使用してください。

## セキュリティ

このリポジトリは公開です。APIキーをコミットしないでください。キーは `.env`
またはデプロイ先のSecret管理へ保存します。詳細は [`SECURITY.md`](./SECURITY.md) を
参照してください。
