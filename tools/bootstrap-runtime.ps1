param(
    [ValidateSet('BootstrapOnly', 'Run', 'Dev')]
    [string]$Mode = 'BootstrapOnly'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
$DownloadsRoot = Join-Path $RuntimeRoot 'downloads'
$NodeRoot = Join-Path $RuntimeRoot 'node'
$PythonRoot = Join-Path $RuntimeRoot 'python'
$EnvFile = Join-Path $RuntimeRoot 'env.cmd'
$NpmStampFile = Join-Path $RuntimeRoot 'npm-install.stamp'
$NodeModulesDir = Join-Path $ProjectRoot 'node_modules'
$PackageJsonFile = Join-Path $ProjectRoot 'package.json'
$PackageLockFile = Join-Path $ProjectRoot 'package-lock.json'

function Write-Status([string]$Message) {
    Write-Host "[BOOTSTRAP] $Message" -ForegroundColor Cyan
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-WindowsArch {
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }

    switch ($arch.ToUpperInvariant()) {
        'ARM64' { return 'arm64' }
        'X86' { return 'x86' }
        default { return 'x64' }
    }
}

function Get-PythonArch {
    switch (Get-WindowsArch) {
        'arm64' { return 'arm64' }
        'x86' { return 'win32' }
        default { return 'amd64' }
    }
}

function Test-CommandWorks([string]$Command, [string[]]$Arguments) {
    try {
        & $Command @Arguments *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
    Write-Status "Downloading $Uri"
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
}

function Expand-DownloadedZip([string]$ZipPath, [string]$DestinationPath) {
    $extractTemp = Join-Path $DownloadsRoot ([Guid]::NewGuid().ToString('N'))

    if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Recurse -Force
    }

    New-Item -ItemType Directory -Path $extractTemp -Force | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $extractTemp -Force

    $children = @(Get-ChildItem -LiteralPath $extractTemp -Force)
    if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
        Move-Item -LiteralPath $children[0].FullName -Destination $DestinationPath
    } else {
        New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
        Get-ChildItem -LiteralPath $extractTemp -Force | Move-Item -Destination $DestinationPath
    }

    Remove-Item -LiteralPath $extractTemp -Recurse -Force
}

function Get-LatestNodeLtsVersion {
    $nodeArch = Get-WindowsArch
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $release = $releases |
        Where-Object { $_.lts -and $_.files -contains "win-$nodeArch" } |
        Select-Object -First 1

    if (-not $release) {
        throw "Could not resolve a Node.js LTS release for win-$nodeArch."
    }

    return $release.version
}

function Ensure-LocalNodeRuntime {
    $nodeExe = Join-Path $NodeRoot 'node.exe'
    $npmCmd = Join-Path $NodeRoot 'npm.cmd'
    $npxCmd = Join-Path $NodeRoot 'npx.cmd'

    if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCmd) -and (Test-Path -LiteralPath $npxCmd)) {
        return [PSCustomObject]@{
            Kind = 'local'
            NodeCommand = $nodeExe
            NpmCommand = $npmCmd
            NpxCommand = $npxCmd
            PathEntries = @($NodeRoot)
        }
    }

    Ensure-Directory $RuntimeRoot
    Ensure-Directory $DownloadsRoot

    $version = Get-LatestNodeLtsVersion
    $arch = Get-WindowsArch
    $zipName = "node-$version-win-$arch.zip"
    $zipPath = Join-Path $DownloadsRoot $zipName
    $downloadUri = "https://nodejs.org/dist/$version/$zipName"

    if (-not (Test-Path -LiteralPath $zipPath)) {
        Invoke-Download -Uri $downloadUri -OutFile $zipPath
    }

    Expand-DownloadedZip -ZipPath $zipPath -DestinationPath $NodeRoot

    return [PSCustomObject]@{
        Kind = 'local'
        NodeCommand = $nodeExe
        NpmCommand = $npmCmd
        NpxCommand = $npxCmd
        PathEntries = @($NodeRoot)
    }
}

function Resolve-NodeRuntime {
    $localNodeExe = Join-Path $NodeRoot 'node.exe'
    $localNpmCmd = Join-Path $NodeRoot 'npm.cmd'
    $localNpxCmd = Join-Path $NodeRoot 'npx.cmd'

    if ((Test-Path -LiteralPath $localNodeExe) -and (Test-Path -LiteralPath $localNpmCmd) -and (Test-Path -LiteralPath $localNpxCmd)) {
        return [PSCustomObject]@{
            Kind = 'local'
            NodeCommand = $localNodeExe
            NpmCommand = $localNpmCmd
            NpxCommand = $localNpxCmd
            PathEntries = @($NodeRoot)
        }
    }

    if ((Test-CommandWorks -Command 'node' -Arguments @('--version')) -and (Test-CommandWorks -Command 'npm.cmd' -Arguments @('--version'))) {
        return [PSCustomObject]@{
            Kind = 'system'
            NodeCommand = 'node'
            NpmCommand = 'npm.cmd'
            NpxCommand = 'npx.cmd'
            PathEntries = @()
        }
    }

    return Ensure-LocalNodeRuntime
}

function Get-LatestPythonRelease {
    $pythonArch = Get-PythonArch
    $listing = Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/' -UseBasicParsing
    $matches = [regex]::Matches($listing.Content, 'href="(3\.(?:13|12|11)\.\d+)/"')
    $versions = $matches |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object { [Version]$_ } -Descending -Unique

    foreach ($version in $versions) {
        $uri = "https://www.python.org/ftp/python/$version/python-$version-embed-$pythonArch.zip"
        try {
            Invoke-WebRequest -Uri $uri -Method Head -UseBasicParsing | Out-Null
            return [PSCustomObject]@{
                Version = $version
                Uri = $uri
            }
        } catch {
        }
    }

    throw "Could not resolve a Python embedded release for $pythonArch."
}

function Ensure-LocalPythonRuntime {
    $pythonExe = Join-Path $PythonRoot 'python.exe'

    if (Test-Path -LiteralPath $pythonExe) {
        return [PSCustomObject]@{
            Kind = 'local'
            PythonCommand = $pythonExe
            PathEntries = @($PythonRoot)
        }
    }

    Ensure-Directory $RuntimeRoot
    Ensure-Directory $DownloadsRoot

    $release = Get-LatestPythonRelease
    $zipPath = Join-Path $DownloadsRoot ([IO.Path]::GetFileName($release.Uri))

    if (-not (Test-Path -LiteralPath $zipPath)) {
        Invoke-Download -Uri $release.Uri -OutFile $zipPath
    }

    Expand-DownloadedZip -ZipPath $zipPath -DestinationPath $PythonRoot

    return [PSCustomObject]@{
        Kind = 'local'
        PythonCommand = $pythonExe
        PathEntries = @($PythonRoot)
    }
}

function Resolve-PythonRuntime {
    $localPythonExe = Join-Path $PythonRoot 'python.exe'
    if (Test-Path -LiteralPath $localPythonExe) {
        return [PSCustomObject]@{
            Kind = 'local'
            PythonCommand = $localPythonExe
            PathEntries = @($PythonRoot)
        }
    }

    foreach ($candidate in @('python', 'py')) {
        if (Test-CommandWorks -Command $candidate -Arguments @('--version')) {
            return [PSCustomObject]@{
                Kind = 'system'
                PythonCommand = $candidate
                PathEntries = @()
            }
        }
    }

    return Ensure-LocalPythonRuntime
}

function Write-EnvFile([psobject]$NodeRuntime, [psobject]$PythonRuntime) {
    Ensure-Directory $RuntimeRoot

    $pathEntries = @(
        @($NodeRuntime.PathEntries) + @($PythonRuntime.PathEntries) |
            Where-Object { $_ } |
            Select-Object -Unique
    )

    $lines = @(
        '@echo off',
        'setlocal',
        ('set "PROJECT_ROOT={0}"' -f $ProjectRoot),
        ('set "RUNTIME_ROOT={0}"' -f $RuntimeRoot)
    )

    if ($pathEntries.Count -gt 0) {
        $pathPrefix = ($pathEntries -join ';')
        $lines += ('set "PATH={0};%PATH%"' -f $pathPrefix)
    }

    $lines += @(
        ('set "NODE_EXE={0}"' -f $NodeRuntime.NodeCommand),
        ('set "NPM_CMD={0}"' -f $NodeRuntime.NpmCommand),
        ('set "NPX_CMD={0}"' -f $NodeRuntime.NpxCommand),
        ('set "PYTHON_EXE={0}"' -f $PythonRuntime.PythonCommand),
        'endlocal & (',
        '  set "PROJECT_ROOT=%PROJECT_ROOT%"',
        '  set "RUNTIME_ROOT=%RUNTIME_ROOT%"',
        '  set "PATH=%PATH%"',
        '  set "NODE_EXE=%NODE_EXE%"',
        '  set "NPM_CMD=%NPM_CMD%"',
        '  set "NPX_CMD=%NPX_CMD%"',
        '  set "PYTHON_EXE=%PYTHON_EXE%"',
        ')'
    )

    Set-Content -LiteralPath $EnvFile -Value ($lines -join [Environment]::NewLine) -Encoding ASCII
}

function Get-FileSignature([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return 'missing'
    }

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
}

function Get-NpmInstallSignature([string]$NodeCommand) {
    $nodeVersion = (& $NodeCommand '--version' | Out-String).Trim()
    return '{0}|{1}|{2}' -f $nodeVersion, (Get-FileSignature -Path $PackageJsonFile), (Get-FileSignature -Path $PackageLockFile)
}

function Ensure-NpmDependencies([string]$NodeCommand, [string]$NpmCommand) {
    $signature = Get-NpmInstallSignature -NodeCommand $NodeCommand
    $currentSignature = ''

    if (Test-Path -LiteralPath $NpmStampFile) {
        $currentSignature = (Get-Content -LiteralPath $NpmStampFile -Raw).Trim()
    }

    if ((Test-Path -LiteralPath $NodeModulesDir) -and ($currentSignature -eq $signature)) {
        Write-Status 'npm dependencies already installed.'
        return
    }

    Write-Status 'Installing npm dependencies...'
    Push-Location $ProjectRoot
    try {
        & $NpmCommand 'install'
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }

    Set-Content -LiteralPath $NpmStampFile -Value $signature -Encoding ASCII
}

function Apply-RuntimeToCurrentProcess([psobject]$NodeRuntime, [psobject]$PythonRuntime) {
    $pathEntries = @(
        @($NodeRuntime.PathEntries) + @($PythonRuntime.PathEntries) |
            Where-Object { $_ } |
            Select-Object -Unique
    )

    if ($pathEntries.Count -gt 0) {
        $env:PATH = ('{0};{1}' -f ($pathEntries -join ';'), $env:PATH)
    }
}

function Start-RunMode([string]$NpmCommand) {
    Write-Status 'Opening browser...'
    Start-Process 'http://localhost:3000' | Out-Null

    Write-Status 'Starting development server in this terminal...'
    Push-Location $ProjectRoot
    try {
        & $NpmCommand 'run' 'dev'
        exit $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Start-DevMode([string]$NpmCommand) {
    $commandLine = 'call "{0}" && "{1}" run dev' -f $EnvFile, $NpmCommand

    Write-Status 'Starting development server in a new terminal...'
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory $ProjectRoot -ArgumentList '/k', $commandLine | Out-Null

    Start-Sleep -Seconds 3
    Write-Status 'Opening browser...'
    Start-Process 'http://localhost:3000' | Out-Null
}

Ensure-Directory $RuntimeRoot
Ensure-Directory $DownloadsRoot

$nodeRuntime = Resolve-NodeRuntime
$pythonRuntime = Resolve-PythonRuntime

Write-Status ("Node runtime: {0}" -f $nodeRuntime.Kind)
Write-Status ("Python runtime: {0}" -f $pythonRuntime.Kind)

Write-EnvFile -NodeRuntime $nodeRuntime -PythonRuntime $pythonRuntime
Apply-RuntimeToCurrentProcess -NodeRuntime $nodeRuntime -PythonRuntime $pythonRuntime
Ensure-NpmDependencies -NodeCommand $nodeRuntime.NodeCommand -NpmCommand $nodeRuntime.NpmCommand

switch ($Mode) {
    'Run' { Start-RunMode -NpmCommand $nodeRuntime.NpmCommand }
    'Dev' { Start-DevMode -NpmCommand $nodeRuntime.NpmCommand }
    default { }
}
