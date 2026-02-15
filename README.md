## Why This Exists

IntelliJ IDEA on WSL has issues:
1. The red square doesn't kill processes properly
2. Processes stay alive after closing the IDE
3. Ports stay bound, blocking subsequent runs

This tool handles process lifecycle correctly with proper signal handling.
