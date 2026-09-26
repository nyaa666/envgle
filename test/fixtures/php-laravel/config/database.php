# Fixture source for envgle integration tests. Never included, never run.

return [
    'default' => env('DB_CONNECTION', 'pgsql'),

    'connections' => [
        'pgsql' => [
            'host' => env('DB_HOST', '127.0.0.1'),
            'port' => env('DB_PORT', '5432'),
            'database' => env('DB_DATABASE', 'example'),
            'username' => env('DB_USERNAME', 'example'),
            // A weak literal fallback for a password: the value is on the
            // weak-value list, so weak-secret owns this line.
            'password' => env('DB_PASSWORD', 'secret'),
        ],
    ],
];
