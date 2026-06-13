import { Controller, Get, Inject } from "@nestjs/common";
import { TestsService } from "./tests.service";

/** Read-only: the distinct tags currently in use across tests (no tag CRUD —
 *  tags exist only as attachments, DESIGN §5). Feeds pickers and filters. */
@Controller("tags")
export class TagsController {
  // Explicit token so DI works without emitted decorator metadata.
  constructor(@Inject(TestsService) private readonly tests: TestsService) {}

  @Get()
  list() {
    return this.tests.listTags();
  }
}
