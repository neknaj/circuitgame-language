# circuitgame-language

`.ncg` 用の VS Code 拡張です。

## 含まれる機能

- `.ncg` のシンタックスハイライト
- 行・列付きの構文診断
- 関数・モジュール呼び出しの引数数チェック
- シグネチャヘルプ
- 補完
- Hover
- 定義ジャンプ
- 参照検索
- リネーム
- ドキュメントシンボル / ワークスペースシンボル
- ドキュメントハイライト
- Folding Range
- `graphical` ブロック中のカラー表示

## インストール

release に添付される `neknaj-circuit-game-language-<version>.vsix` を VS Code の `Extensions: Install from VSIX...` で入れれば、そのまま `.ncg` に反映されます。

## VSIX の作成

```sh
cd vscode-ncg
npm install
npm run package
```

生成物: `vscode-ncg/circuit-game-language.vsix`

## 開発時

```sh
cd vscode-ncg
npm install
npm run build
```

VS Code で `vscode-ncg` ディレクトリを開いて `F5` でも確認できます。

## Release

`main` への push で GitHub Actions が build し、最新 tag の patch を 1 つ上げた release を自動作成します。
