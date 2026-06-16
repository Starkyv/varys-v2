import { Controller, Get } from "@nestjs/common";
import { authMethods } from "./auth";
import { Public } from "./public.decorator";

/**
 * Public read of the enabled sign-in methods, so the login screen renders only what the
 * server actually accepts (driven by `VARYS_AUTH_METHODS`). Public — it's consumed
 * pre-authentication, on the login screen.
 */
@Public()
@Controller("auth-config")
export class AuthConfigController {
  @Get()
  get(): { emailPassword: boolean; google: boolean } {
    return authMethods;
  }
}
