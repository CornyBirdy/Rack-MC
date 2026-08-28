@echo off
rem ---------------------------------------------------------------------------
rem MC Hoster - give a parallel session its own copy of the repo.
rem
rem Two agents editing this folder at once overwrite each other: each writes
rem whole files from its own buffer, so whoever saves last silently reverts the
rem other's edits. A git worktree fixes it properly - a second checkout, on its
rem own branch, in its own directory, sharing this repo's history.
rem
rem   worktree.bat add <name>     make ..\MC_hoster-<name> on branch <name>
rem   worktree.bat list           show every worktree and the branch it's on
rem   worktree.bat remove <name>  delete the directory (the branch survives)
rem
rem Each worktree gets its own git-ignored data\ folder, so servers, worlds and
rem downloaded runtimes never collide either. The panel's port would still
rem collide, so run each one on its own:  set MC_PORT=8101 && run.bat
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

if "%~1"=="" goto usage
if /i "%~1"=="list" goto list
if /i "%~1"=="add" goto add
if /i "%~1"=="remove" goto remove
goto usage

:list
echo === worktrees of this repo ===
git worktree list
goto end

:add
if "%~2"=="" (
  echo [X] Give the worktree a name, e.g.  worktree.bat add modrinth
  exit /b 1
)
set "DEST=..\MC_hoster-%~2"
if exist "%DEST%" (
  echo [X] %DEST% already exists. Pick another name, or:  worktree.bat remove %~2
  exit /b 1
)
rem An existing branch is checked out as-is; a new name starts a branch off main.
git show-ref --verify --quiet "refs/heads/%~2"
if errorlevel 1 (
  git worktree add -b "%~2" "%DEST%" main
) else (
  git worktree add "%DEST%" "%~2"
)
if errorlevel 1 (
  echo [X] git could not create the worktree - see the error above.
  exit /b 1
)
echo.
echo [ok] Worktree ready.
echo      Folder:  %DEST%
echo      Branch:  %~2
echo.
echo Point the parallel session at that folder instead of this one. When it's
echo done:  git checkout main  ^&^&  git merge %~2
goto end

:remove
if "%~2"=="" (
  echo [X] Which one? Try:  worktree.bat list
  exit /b 1
)
git worktree remove "..\MC_hoster-%~2"
if errorlevel 1 (
  echo     Uncommitted changes in there? Commit them first, or force it with:
  echo       git worktree remove --force ..\MC_hoster-%~2
  exit /b 1
)
echo [ok] Removed. Branch "%~2" still holds the commits.
goto end

:usage
echo MC Hoster - worktrees for parallel sessions
echo.
echo   worktree.bat add ^<name^>     new checkout at ..\MC_hoster-^<name^> on branch ^<name^>
echo   worktree.bat list            every worktree and its branch
echo   worktree.bat remove ^<name^>  delete that checkout (branch survives)
echo.
echo Run one agent per worktree. Nothing they do can overwrite each other,
echo and each merges back to main when it's finished.

:end
endlocal
