#!/bin/bash
# Runs after all other init scripts.
# Replace shells with /bin/false so the terminal is useless.
echo "**** disabling shell access ****"
ln -sf /bin/false /usr/local/bin/bash
ln -sf /bin/false /usr/local/bin/sh
ln -sf /bin/false /usr/local/bin/zsh
# /usr/local/bin comes before /bin in PATH for code-server
echo "**** shell access disabled ****"
