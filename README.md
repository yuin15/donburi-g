# Slot-chan

**60秒。回して、競って、しゃべるライバルと勝負する。**

チーム **donburi** のゲームソン向けスロット対戦デモです。クリック・Spaceで連打し、独立して回転するライバルと獲得コインを競います。GPT-Liveの音声とLiveAvatarの映像は、任意で追加できます。

**[公開デモで遊ぶ](https://slot-chan.vercel.app/) · [メンバー向け引き継ぎ](docs/demo-handoff.md) · [3Dモデルの配布](https://github.com/yuin15/donburi-g/releases/tag/demo-2026-09-13) · [MVVM構成](docs/architecture.md)**

対象は **PC・横画面1280×720以上・マウスとキーボード**。ゲーム画面は英語です。

![CPU対戦の画面例：大きな得点、下向きリール、残り10秒の演出](docs/evidence/finale/final-eight-1280.webp)

*画面は演出確認用のDEVプレビューです。*

## 遊び方

1. **PLAY NOW** で開始。CPU対戦にはAPIキー・招待コード・マイク・DBは不要です。
2. **SPIN** をクリック、または **Space** で回転。回転中にもう一度押すと、次の1回を予約できます。
3. ライバルは操作に関係なく **2秒ごと** に自動回転します。
4. **60秒の獲得コインが多い方が勝利**。最後のリールが止まってから結果を表示し、**REMATCH** で再戦できます。

配当は中央の1ラインだけが対象です。

| 揃った絵柄 | 獲得コイン |
| --- | ---: |
| チェリー × 3 | 120 |
| ベル × 3 | 240 |
| 7 × 3 | 1,200 |

プレイヤーは1.1秒以上の間隔で最大55回、ライバルは30回転。両者とも同じ基本リールを使い、改造や途中の選択操作はありません。詳しくは[ゲーム規則](docs/game-rules.md)。

## すぐに開発を始める

**Node.js 22以上**を用意します。

```bash
git clone https://github.com/yuin15/donburi-g.git
cd donburi-g
npm ci
npm run dev
```

ターミナルに表示されたURLを開けば、CPU対戦・結果・再戦まで確認できます。通常のVite開発サーバーはCPU対戦の確認用です。ライブ機能には、以下のサーバー側APIと環境設定も必要です。

## 任意のAI音声・映像

| モード | 使用するサービス | 追加の準備 |
| --- | --- | --- |
| CPU対戦（標準） | なし | なし |
| AI音声 | OpenAI GPT-Live | 招待コード、マイク許可、サーバー側の音声設定 |
| AI音声＋映像 | GPT-Live / LiveAvatar / LiveKit | 音声設定に加え、LiveAvatarの設定 |

**ADD AI VOICE · OPTIONAL** を開き、招待コードを入力して **CONNECT AI VOICE**。接続後に **PLAY** を押します。映像を付ける場合だけ **Add live video** にチェックを入れます。音声だけならLiveAvatarには接続しません。

**MIC** はマイク入力、**VOICE** はライバルの声、**SOUND** はゲーム効果音を操作します。**LISTENING TO YOU / RIVAL REPLY** は発話検出と返事の字幕受信を表示します。マイク音声はOpenAIへ送信され、音声・映像APIの利用枠を消費します。初期接続に失敗した場合はCPU対戦へ進めます。接続後に任意の音声・映像が終了しても同じ試合を続行します。試合用WebSocket自体が切れた場合は、その旨を表示して対戦を終了します。

### サーバー側の設定

[`.env.example`](.env.example) を参考に、Git対象外の環境ファイル、またはVercelのEnvironment Variablesへ設定してください。

| 環境変数 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | GPT-Liveの呼び出し |
| `SESSION_SIGNING_KEY` | セッション署名鍵。24文字以上のランダム値 |
| `MVP_INVITE_CODE` | ライブ機能の招待コード |
| `LIVE_MODE_ENABLED=true` | ライブ機能の有効化 |
| `ALLOWED_ORIGINS` | 利用するサイトのOrigin |
| `LIVEAVATAR_API_KEY` | 映像を選ぶ場合に必要 |
| `LIVEAVATAR_AVATAR_ID` | 任意の映像アバター指定。未指定時は利用可能な公開アバターを使用 |

API入口は [`api/access.ts`](api/access.ts) / [`api/ws.ts`](api/ws.ts)、デプロイ設定は [`vercel.json`](vercel.json) です。モデル・声・接続数の既定値は [`.env.example`](.env.example)、運用手順は [operations.md](docs/operations.md) を参照してください。

共有DBやRedis/Upstashは必須ではありません。招待制デモ向けにプロセス内の接続制限を使っています。これは全インスタンス共通の課金上限ではありません。音声は接続から120秒以内に終了処理を始めますが、進行中の60秒対戦は続きます。

## 変更する場所

TypeScript / Vite / Three.jsで実装し、**MVVM**でゲーム規則・進行・描画を分けています。

| 場所 | 主な役割 |
| --- | --- |
| [`src/domain/`](src/domain/) | Model。抽選、配当、回転間隔、試合の集計 |
| [`src/viewmodel/`](src/viewmodel/) | ViewModel。進行、入力予約、表示状態、CPU/Liveの切り替え |
| [`src/view/`](src/view/) | View。DOM、配置、Three.jsのリール・当たり演出、効果音 |
| [`art-source/houdini/`](art-source/houdini/) | コイン・ベル・チェリーの制作スクリプト、OBJ、拡大プレビュー |
| [`src/client/`](src/client/) | 通信、マイク、音声再生、任意の映像接続 |
| [`server/`](server/) / [`api/`](api/) | ライブ対戦、外部API、接続の開始と終了 |

筐体・リール・光・立体モデルは1つのThree.js描画にまとめ、文字と操作はHTML/CSSで扱います。背景・表情・絵柄は3枚の共有WebP。Houdini製のコインは厚み・両面の7・刻みのある縁を持ち、24枚が同じ形状を共有します。ベル・チェリーの小当たりでは、WINの横に[同じ種類の立体モデル](docs/houdini-symbols.md)が現れます。効果音はWeb Audioで合成しています。静止中・非表示中は連続描画を止め、LiveAvatar用SDKは映像を選んだときだけ読み込みます。

詳しい責務と変更例は [architecture.md](docs/architecture.md)、作業方針は [AGENTS.md](AGENTS.md) を参照してください。

## 引き継ぎ時点の状態

2026-09-13時点で、無料CPU対戦と任意のライブ機能を公開しています。下向きリール、大型得点、BIG WIN、独立したライバル回転、残り10秒のライト・音、結果・再戦・自己ベスト・連勝表示を実装済みです。Houdini製のコイン・ベル・チェリーと[制作手順](art-source/houdini/README.md)を追加しています。公開サイトへの反映状況は[公開記録](docs/current-status.md#公開記録)を参照してください。自己ベストと連勝はページを再読み込みするとリセットされます。

実APIの実況・LiveAvatar映像・結果反応を収録した **約1分23秒の引き継ぎ動画** を別途配布しています。収録時はプレイヤーのマイクをミュートしており、人が話しかける会話・割り込みの評価とは分けています。動画・実際の会話内容はこのリポジトリに含めません。

- **デモとしての完成範囲：** 無料CPU対戦、任意のAI音声・映像、3Dモデルの制作元、公開版、引き継ぎ資料を揃えています。[今回の会話表示の修正](docs/conversation-feedback.md)では、割り込み後の字幕の混在も解消しました。
- **追加評価：** 修正版の実マイクによる会話・割り込みの体感、実Edge、初見プレイは未評価です。未評価を合格扱いにはせず、今回のゲームソン向けデモの完成条件から分けています。[確認記録と制限](docs/current-status.md)。
- **今後の優先順位：** 実画面を見て、見栄え・当たりの爽快感・60秒対戦の面白さを改善します。スマートフォン対応、追加の試合同期検証、商用向け基盤は現在の対象外です。
- **資料の読み方：** 古い改造・同時回転の検証資料は当時の履歴です。現在の仕様は[ゲーム規則](docs/game-rules.md)、実施済みと未確認の区別は[現在地](docs/current-status.md)を参照してください。

## 確認コマンド

```bash
npm run typecheck
npm run lint
npm test
npm run check:server-runtime
npm run build
```

GitHub Actionsでも上記を実行します。変更に必要な確認と既存CIを通し、見た目や操作の改善は実画面で確認してください。

## 秘密情報と素材

**APIキー、トークン、署名鍵、招待コード、環境ファイル、個人のメールアドレス、実際の会話・マイク音声をコミットしないでください。** 引き継ぎ時の秘密値はコードと別の安全な経路で共有します。[SECURITY.md](SECURITY.md) / [運用手順](docs/operations.md)。

筐体・キャラクター表情・絵柄・アイコン用コインは本プロジェクト用に生成した画像です。[画像素材](docs/visual-assets.md) / [画面検証](docs/visual-redesign-verification.md)。当たり演出用のコイン・ベル・チェリーはHoudini Apprenticeで制作し、ゲームソンの非商用デモ向けとして扱います。[3Dモデルの制作元・利用条件](art-source/houdini/README.md)。LiveAvatarとGPT-Liveの接続設計は、MITライセンスの `heygen-com/liveavatar-gpt-live-demos` を参考にしています。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
