# Fixture source for envgle integration tests. Never loaded, never run.
module ExampleApp
  class Application < Rails::Application
    config.load_defaults 7.1

    # Required: the application refuses to boot without it.
    secret_key_base = ENV.fetch("SECRET_KEY_BASE")
    # Required with a block fallback: the block runs when the name is absent.
    redis_url = ENV.fetch("REDIS_URL") { "redis://localhost:6379" }
    rails_env = ENV.fetch("RAILS_ENV", "development")

    config.x.secret_key_base = secret_key_base
    config.x.redis_url = redis_url
    config.x.rails_env = rails_env
  end
end
