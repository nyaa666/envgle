// Fixture source for envgle integration tests. Never built, never run.
// ConnectionStrings:Default is a configuration key with a colon in it, not an
// environment variable name, so no accessor may report it.
var builder = WebApplication.CreateBuilder(args);

var connection = builder.Configuration["ConnectionStrings:Default"];
var environment = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT");
var smtpPassword = Environment.GetEnvironmentVariable("SMTP_PASSWORD", EnvironmentVariableTarget.Local);

var app = builder.Build();

app.MapGet("/health", () => Results.Ok(new
{
    environment,
    databaseConfigured = connection is not null,
    smtpConfigured = smtpPassword is not null,
}));

app.Run();
