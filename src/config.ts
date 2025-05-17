interface Config {
  password: {
    salt: string;
  };
  server: {
    port: number;
    host: string;
  };
}

const config: Config = {
  password: {
    salt: process.env.PASSWORD_SALT || "default_salt_change_in_production",
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: process.env.HOST || "0.0.0.0",
  },
};

export default config;
