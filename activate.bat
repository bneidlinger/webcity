@echo off
echo.
echo ===================================
echo SimCity Web Development Environment
echo ===================================
echo.

REM Activate Python virtual environment
call venv\Scripts\activate.bat

echo Python venv activated
echo.
echo Available commands:
echo   npm run dev    - Start development server (http://localhost:5173)
echo   npm run build  - Build for production
echo   npm run preview - Preview production build
echo.
echo Python environment: venv (activated)
echo Node.js ready for web development
echo.