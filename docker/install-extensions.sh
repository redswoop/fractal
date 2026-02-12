#!/bin/bash
echo "**** installing writing extensions ****"

code-server --install-extension yzhang.markdown-all-in-one
code-server --install-extension shd101wyy.markdown-preview-enhanced
code-server --install-extension streetsidesoftware.code-spell-checker
code-server --install-extension vscode.git

echo "**** writing extensions installed ****"
