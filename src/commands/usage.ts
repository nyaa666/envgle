export const USAGE = `envgle ${'{version}'} - audit every environment variable your code reads

USAGE
  envgle [command] [path] [options]

COMMANDS
  scan [path]              Audit the project and report findings (default command)
  check [path]             Same as scan, for CI: silent success, exit 1 on findings
  init                     Generate a .env.example skeleton from the code and env files
  docs                     Render the environment variable reference as markdown
  fmt                      Normalise dotenv files (trailing whitespace, key order, final newline)
  why <NAME>               Show where one variable is declared, read and referenced
  rules                    List every rule with its severity and category
  help                     Show this help
  version                  Print the version

OPTIONS
  --format <fmt>           human | json | sarif | markdown | quiet      (default: human)
  --fail-on <level>        error | warn | info | none                   (default: error)
  --config <path>          Use a specific configuration file
  --project <dir>          Directory to audit                           (default: .)
  --rule <id>              Only run this rule (repeatable)
  --ignore-rule <id>       Never run this rule (repeatable)
  --ignore-var <glob>      Never report this variable (repeatable)
  --max-issues <n>         Maximum findings printed per file            (default: 20)
  --max-file-size <kb>     Skip files larger than this                  (default: 64)
  --no-gitignore           Do not prune directories with .gitignore rules
  --no-color               Disable ANSI colours
  --quiet                  Print nothing, only set the exit code
  --short                  One line per finding
  --verbose                Also print skipped files, parser notes and config warnings
  --dry-run                Never write a file
  --write [path]           Write the result (init, docs, fmt)
  --check                  Report what fmt would change without writing  (default)
  --json                   Machine readable output where applicable      (rules)
  -h, --help               Show this help
  -v, --version            Print the version

EXIT CODES
  0  nothing at or above --fail-on
  1  findings at or above --fail-on
  2  configuration or usage error

EXAMPLES
  envgle                              audit the current directory
  envgle check --fail-on warn         stricter CI gate
  envgle --format sarif > out.sarif   upload to GitHub code scanning
  envgle why DATABASE_URL             trace one variable
  envgle init --write                 create .env.example
  envgle fmt --write                  normalise dotenv files
`;
