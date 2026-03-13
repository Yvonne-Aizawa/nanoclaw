sqlite3 ../store/messages.db "DELETE FROM sessions WHERE group_folder = 'telegram_main';"
rm -rf ../data/sessions/telegram_main/.claude
echo "DONE"
