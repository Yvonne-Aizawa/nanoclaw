sqlite3 ../workspace/store/messages.db "DELETE FROM sessions WHERE group_folder = 'telegram_main';"
rm -rf ../workspace/data/sessions/*/.claude/backups

echo "DONE"
