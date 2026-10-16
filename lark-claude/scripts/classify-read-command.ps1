param([Parameter(Mandatory = $true)][string]$ProjectRoot)

$ErrorActionPreference = 'Stop'

function Write-Decision([bool]$Safe, [string]$Reason, $Action = $null) {
    [Console]::Out.WriteLine(([ordered]@{
        version = 1
        safe = $Safe
        reason = $Reason
        action = $Action
    } | ConvertTo-Json -Compress -Depth 4))
}

function Fail([string]$Reason) {
    Write-Decision $false $Reason
    exit 0
}

function Get-Literal([System.Management.Automation.Language.Ast]$Ast) {
    if ($Ast -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { return $null }
    return $Ast.Value
}

function Test-LiteralPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 4096) { return $false }
    if ($Value -match '[*?\[\]$`]' -or $Value.StartsWith('~')) { return $false }
    if ($Value.StartsWith('\\') -or $Value.StartsWith('//') -or $Value -match '^(\\\\[.?]\\|[A-Za-z]+::)') { return $false }
    if ($Value -match '(^|[\\/])\.\.([\\/]|$)') { return $false }
    if ($Value.Length -gt 2 -and $Value.Substring(2).Contains(':')) { return $false }
    return $true
}

function Parse-Command($Statement) {
    if ($Statement -isnot [System.Management.Automation.Language.PipelineAst]) { return $null }
    if ($Statement.PipelineElements.Count -ne 1 -or $Statement.Redirections.Count -ne 0) { return $null }
    $command = $Statement.PipelineElements[0]
    if ($command -isnot [System.Management.Automation.Language.CommandAst]) { return $null }
    if ($command.InvocationOperator.ToString() -ne 'Unknown') { return $null }
    $name = $command.GetCommandName()
    if ($name -notin @('Get-Content', 'Get-ChildItem', 'Test-Path', 'Resolve-Path')) { return $null }

    $parameters = @{}
    $positionals = [System.Collections.Generic.List[string]]::new()
    $expectValue = $null
    foreach ($element in $command.CommandElements | Select-Object -Skip 1) {
        if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
            if ($null -ne $expectValue -or $null -ne $element.Argument -or $parameters.ContainsKey($element.ParameterName)) { return $null }
            $parameters[$element.ParameterName] = $true
            if ($element.ParameterName -in @('LiteralPath', 'PathType')) { $expectValue = $element.ParameterName }
            continue
        }
        $literal = Get-Literal $element
        if ($null -eq $literal) { return $null }
        if ($null -ne $expectValue) {
            $parameters[$expectValue] = $literal
            $expectValue = $null
        } else {
            $positionals.Add($literal)
        }
    }
    if ($null -ne $expectValue) { return $null }

    $allowed = switch ($name) {
        'Get-Content' { @('Raw', 'LiteralPath') }
        'Get-ChildItem' { @('Force', 'LiteralPath') }
        'Test-Path' { @('LiteralPath', 'PathType') }
        'Resolve-Path' { @('LiteralPath') }
    }
    foreach ($key in $parameters.Keys) { if ($key -cnotin $allowed) { return $null } }
    if ($parameters.ContainsKey('PathType') -and $parameters['PathType'] -notin @('Leaf', 'Container', 'Any')) { return $null }
    if ($parameters.ContainsKey('LiteralPath') -and $positionals.Count -ne 0) { return $null }
    if (-not $parameters.ContainsKey('LiteralPath') -and $positionals.Count -gt 1) { return $null }
    $pathValue = if ($parameters.ContainsKey('LiteralPath')) { $parameters['LiteralPath'] } elseif ($positionals.Count -eq 1) { $positionals[0] } else { $null }
    if ($name -ne 'Get-ChildItem' -and $null -eq $pathValue) { return $null }
    if ($null -ne $pathValue -and -not (Test-LiteralPath $pathValue)) { return $null }
    if ($name -eq 'Get-Content' -and ($parameters.Keys | Where-Object { $_ -notin @('Raw', 'LiteralPath') })) { return $null }

    return [pscustomobject]@{ Name = $name; Path = $pathValue }
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 16384) { Fail 'invalid_request' }
    $request = $raw | ConvertFrom-Json
    if ($request.version -ne 1 -or $request.script -isnot [string] -or $request.cwd -isnot [string]) { Fail 'invalid_request' }
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($request.script, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { Fail 'parse_error' }
    if (($null -ne $ast.UsingStatements -and $ast.UsingStatements.Count -ne 0) -or
        ($null -ne $ast.Attributes -and $ast.Attributes.Count -ne 0) -or
        $null -ne $ast.ScriptRequirements) { Fail 'unsupported_ast' }
    if ($null -ne $ast.ParamBlock -or $null -ne $ast.DynamicParamBlock -or $null -ne $ast.BeginBlock -or $null -ne $ast.ProcessBlock -or $null -ne $ast.CleanBlock) { Fail 'unsupported_ast' }
    if ($null -eq $ast.EndBlock -or $ast.EndBlock.Traps.Count -ne 0 -or $ast.EndBlock.Statements.Count -ne 1) { Fail 'unsupported_ast' }

    $statement = $ast.EndBlock.Statements[0]
    if ($statement -is [System.Management.Automation.Language.IfStatementAst]) {
        if ($statement.Clauses.Count -ne 1 -or $null -ne $statement.ElseClause) { Fail 'unsupported_ast' }
        $test = Parse-Command $statement.Clauses[0].Item1
        $body = $statement.Clauses[0].Item2
        if ($null -eq $test -or $test.Name -ne 'Test-Path' -or $body.Statements.Count -ne 1 -or $body.Traps.Count -ne 0) { Fail 'unsupported_ast' }
        $read = Parse-Command $body.Statements[0]
        if ($null -eq $read -or $read.Name -ne 'Get-Content' -or $test.Path -cne $read.Path) { Fail 'unsupported_ast' }
        Write-Decision $true 'safe_conditional' ([ordered]@{ kind = 'conditional'; path = $read.Path })
        exit 0
    }

    $parsed = Parse-Command $statement
    if ($null -eq $parsed) { Fail 'unsupported_ast' }
    $mapping = @{
        'Get-Content' = @('safe_read', 'read')
        'Get-ChildItem' = @('safe_list', 'listFiles')
        'Test-Path' = @('safe_test', 'test')
        'Resolve-Path' = @('safe_resolve', 'resolve')
    }
    $decision = $mapping[$parsed.Name]
    Write-Decision $true $decision[0] ([ordered]@{ kind = $decision[1]; path = $parsed.Path })
} catch {
    Write-Decision $false 'invalid_request'
}
