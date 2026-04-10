import { Module } from "@nestjs/common"
import { UsageStatsModule } from "../../usage/usage-stats.module"
import { ModelModule } from "../model.module"
import { ClaudeApiService } from "./claude-api.service"

@Module({
  imports: [UsageStatsModule, ModelModule],
  providers: [ClaudeApiService],
  exports: [ClaudeApiService],
})
export class ClaudeApiModule {}
